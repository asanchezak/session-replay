import uuid
from enum import Enum

from sqlalchemy import JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class ActorType(str, Enum):
    system = "system"
    human = "human"
    ai = "ai"
    extension = "extension"


class EventType(str, Enum):
    click = "click"
    type = "type"
    select = "select"
    submit = "submit"
    scroll = "scroll"
    navigate = "navigate"
    hover = "hover"
    copy = "copy"
    paste = "paste"
    tab_change = "tab_change"
    run_started = "run_started"
    run_paused = "run_paused"
    run_resumed = "run_resumed"
    run_completed = "run_completed"
    run_failed = "run_failed"
    run_canceled = "run_canceled"
    checkpoint = "checkpoint"
    recovery_attempt = "recovery_attempt"
    recovery_success = "recovery_success"
    recovery_failure = "recovery_failure"
    intervention = "intervention"
    ai_invocation = "ai_invocation"
    screenshot = "screenshot"
    dom_snapshot = "dom_snapshot"


class EventLog(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "event_log"

    run_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True, index=True)
    step_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    actor_type: Mapped[str] = mapped_column(
        String(20), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(
        String(30), nullable=False, index=True
    )
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    page_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    previous_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
