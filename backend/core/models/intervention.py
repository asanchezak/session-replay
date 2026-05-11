from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class HumanIntervention(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "human_interventions"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    trigger_reason: Mapped[str] = mapped_column(String(100), nullable=False)
    page_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    checkpoint_event_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    resolution_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_action: Mapped[str | None] = mapped_column(String(50), nullable=True)
    paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
