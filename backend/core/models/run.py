from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class ExecutionRun(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "execution_runs"

    workflow_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    browser_session_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="idle", index=True
    )
    current_step_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_steps: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pause_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Phase 6: goal-first runtime cursor. Optional jsonb capturing phases
    # completed/active/pending and intents satisfied/outstanding. The
    # primary cursor will eventually be derived from this instead of
    # current_step_index; both kept for now during the transition.
    goal_progress: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    extracted_data: Mapped[list | None] = mapped_column(JSON, nullable=True, default=list)
    # Workstream C: rolling OpenAI message list for the tool-use agent loop.
    # Trimmed to the last N=20 messages with image blocks stripped from prior
    # turns by `services.agent_conversation`. Bounded so it does not balloon.
    ai_conversation: Mapped[list | None] = mapped_column(JSON, nullable=True, default=list)
