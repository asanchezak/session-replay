"""create semantic workflow intelligence tables

Revision ID: 011
Revises: 010
Create Date: 2026-05-13
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. workflow_analyses — one per workflow, stores AI-inferred semantic metadata
    op.create_table(
        "workflow_analyses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("analysis_version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("workflow_goal", sa.Text(), nullable=True),
        sa.Column("workflow_summary", sa.Text(), nullable=True),
        sa.Column("domain_context", sa.String(50), nullable=True),
        sa.Column("confidence_overall", sa.Float(), nullable=False, server_default=sa.text("0.0")),
        sa.Column("ai_model_used", sa.String(50), nullable=True),
        sa.Column("ai_inference_metadata", JSONB(), nullable=True),
        sa.Column("ambiguity_notes", JSONB(), nullable=True),
        sa.Column("is_user_edited", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("replay_strategy", sa.String(30), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_id"),
    )
    op.create_index("ix_workflow_analyses_workflow_id", "workflow_analyses", ["workflow_id"])

    # 2. semantic_phases — groups of steps sharing a semantic purpose
    op.create_table(
        "semantic_phases",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("phase_index", sa.Integer(), nullable=False),
        sa.Column("phase_name", sa.String(100), nullable=False),
        sa.Column("phase_goal", sa.Text(), nullable=True),
        sa.Column("start_step_index", sa.Integer(), nullable=False),
        sa.Column("end_step_index", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_semantic_phases_workflow_id", "semantic_phases", ["workflow_id"])

    # 3. semantic_actions — higher-level interpretation of each step
    op.create_table(
        "semantic_actions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("step_id", sa.String(36), nullable=True),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("semantic_action_type", sa.String(50), nullable=False),
        sa.Column("semantic_description", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False, server_default=sa.text("0.0")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_semantic_actions_workflow_id", "semantic_actions", ["workflow_id"])

    # 4. workflow_parameters — inferred runtime parameters
    op.create_table(
        "workflow_parameters",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("parameter_key", sa.String(100), nullable=False),
        sa.Column("parameter_type", sa.String(20), nullable=False, server_default=sa.text("'string'")),
        sa.Column("default_value", sa.Text(), nullable=True),
        sa.Column("inferred_from_step", sa.Integer(), nullable=True),
        sa.Column("inferred_value", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False, server_default=sa.text("0.0")),
        sa.Column("is_required", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("validation_rules", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workflow_parameters_workflow_id", "workflow_parameters", ["workflow_id"])

    # 5. output_specifications — what the workflow produces
    op.create_table(
        "output_specifications",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("output_type", sa.String(50), nullable=False, server_default=sa.text("'unknown'")),
        sa.Column("output_schema", JSONB(), nullable=True),
        sa.Column("schema_confidence", sa.Float(), nullable=False, server_default=sa.text("0.0")),
        sa.Column("sample_output", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_id"),
    )
    op.create_index("ix_output_specifications_workflow_id", "output_specifications", ["workflow_id"])

    # 6. workflow_templates — versioned reusable templates
    op.create_table(
        "workflow_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("template_version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("template_data", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workflow_templates_workflow_id", "workflow_templates", ["workflow_id"])


def downgrade() -> None:
    op.drop_table("workflow_templates")
    op.drop_table("output_specifications")
    op.drop_table("workflow_parameters")
    op.drop_table("semantic_actions")
    op.drop_table("semantic_phases")
    op.drop_table("workflow_analyses")
