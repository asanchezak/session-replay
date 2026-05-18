from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text
from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class PageStateSnapshot(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "page_state_snapshots"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    trigger: Mapped[str] = mapped_column(String(30), nullable=False)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    visible_text_excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    element_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    blocking_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    is_blocking: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    visible_elements: Mapped[list | None] = mapped_column(JSON, nullable=True)
    dom_snippet_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_page_state_snapshots_run_step", "run_id", "step_index"),
    )
