"""Phase 4: per-decision telemetry — one row per agent decision.

Records:
- What the AI / fast-path decided
- How confident it was
- What actually happened (the extension reports back via /agent/result)
- How long the round-trip took
- Which model produced the decision

Designed to power:
- The frontend AIDecisionTrace component (per-step prompt+response)
- The analytics page (confidence vs. outcome calibration)
- Phase 5 learning_service (which decisions led to healing → low stability)
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class AIDecisionOutcome(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "ai_decision_outcomes"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    actual_outcome: Mapped[str | None] = mapped_column(String(20), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
    thinking_steps: Mapped[list | None] = mapped_column(JSON, nullable=True)
    reasoning_chain_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    decision_context: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # IMPORTANT: must be tz-aware to match `datetime.now(UTC)` writes from
    # AIOutcomeService.resolve_latest. The 2026-05-15 ghost-run incident
    # ('a31c67d0-…') was caused by this column being TIMESTAMP WITHOUT TZ.
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
