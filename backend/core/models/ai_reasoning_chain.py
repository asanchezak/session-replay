from __future__ import annotations

from sqlalchemy import Index, Integer, String, Text
from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class AIReasoningChain(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "ai_reasoning_chains"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    # Soft FK — avoids FK constraint failures when telemetry is written in a
    # savepoint that may be rolled back separately from the parent transaction.
    decision_outcome_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    thinking_steps: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    full_reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    invocation_type: Mapped[str] = mapped_column(
        String(30), nullable=False, default="step_decision"
    )
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_ai_reasoning_chains_run_step", "run_id", "step_index"),
    )
