from __future__ import annotations

from sqlalchemy import Boolean, Float, Index, Integer, String, Text
from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class RecoveryAttemptTrace(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "recovery_attempt_traces"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # 'retry'|'heal'|'adapt'|'last_chance'|'supervisor'
    trigger: Mapped[str] = mapped_column(String(20), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    likely_cause: Mapped[str | None] = mapped_column(Text, nullable=True)
    analysis_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    suggested_action: Mapped[str | None] = mapped_column(String(30), nullable=True)
    suggested_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    suggested_selectors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    should_retry: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    should_skip: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 'applied'|'rejected'|'skipped' — set post-hoc when caller determines outcome
    outcome: Mapped[str | None] = mapped_column(String(20), nullable=True)
    ai_invoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_recovery_attempt_traces_run_step", "run_id", "step_index"),
    )
