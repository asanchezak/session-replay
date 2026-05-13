from datetime import datetime

from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class AuditOutbox(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "audit_outbox"

    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_type: Mapped[str] = mapped_column(String(20), default="system")
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    processed: Mapped[bool] = mapped_column(default=False)
    processed_at: Mapped[datetime | None] = mapped_column(nullable=True)
