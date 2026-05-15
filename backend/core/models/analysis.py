from datetime import datetime

from sqlalchemy import Boolean, Float, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class WorkflowAnalysis(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflow_analyses"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True, index=True)
    analysis_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    workflow_goal: Mapped[str | None] = mapped_column(Text, nullable=True)
    workflow_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    domain_context: Mapped[str | None] = mapped_column(String(50), nullable=True)
    confidence_overall: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    ai_model_used: Mapped[str | None] = mapped_column(String(50), nullable=True)
    ai_inference_metadata: Mapped[dict | None] = mapped_column("ai_inference_metadata", JSON, nullable=True)
    ambiguity_notes: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_user_edited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    replay_strategy: Mapped[str | None] = mapped_column(String(30), nullable=True)


class SemanticPhase(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "semantic_phases"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    phase_index: Mapped[int] = mapped_column(Integer, nullable=False)
    phase_name: Mapped[str] = mapped_column(String(100), nullable=False)
    phase_goal: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    end_step_index: Mapped[int] = mapped_column(Integer, nullable=False)


class SemanticAction(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "semantic_actions"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    semantic_action_type: Mapped[str] = mapped_column(String(50), nullable=False)
    semantic_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)


class WorkflowParameter(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflow_parameters"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    parameter_key: Mapped[str] = mapped_column(String(100), nullable=False)
    parameter_type: Mapped[str] = mapped_column(String(20), nullable=False, default="string")
    default_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    inferred_from_step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    inferred_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    is_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    validation_rules: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Phase 5: parameter validation history — incremented by learning_service
    # after each terminal run. success_rate = success_count / validation_count.
    validation_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    success_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_validated_at: Mapped[datetime | None] = mapped_column(nullable=True)


class OutputSpecification(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "output_specifications"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True, index=True)
    output_type: Mapped[str] = mapped_column(String(50), nullable=False, default="unknown")
    output_schema: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    schema_confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    sample_output: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class WorkflowTemplate(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflow_templates"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    template_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    template_data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
