from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class RunSummary(Base, TimestampMixin, UUIDMixin):
    """Aggregate metrics per run, written when the run reaches a terminal state.

    One row per run. Queried instead of recounting from event_log to give
    fast access to run-level KPIs (adapt rate, AI latency, step counts).
    """

    __tablename__ = "run_summaries"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    total_steps: Mapped[int] = mapped_column(Integer, nullable=False)
    steps_completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    steps_skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    steps_healed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    steps_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    adapt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pause_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    supervisor_resumes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_invocations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_ai_latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    goal_progress_final: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    __table_args__ = (
        UniqueConstraint("run_id", name="uq_run_summaries_run_id"),
    )
