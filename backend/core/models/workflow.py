from sqlalchemy import JSON, Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class Workflow(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflows"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="draft", index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class WorkflowStep(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflow_steps"

    workflow_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    action_type: Mapped[str] = mapped_column(String(30), nullable=False)
    intent: Mapped[str | None] = mapped_column(Text, nullable=True)
    selector_chain: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    accessibility_metadata: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    text_anchors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    dom_context: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    success_condition: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    failure_condition: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ai_hint: Mapped[str | None] = mapped_column(Text, nullable=True)
    checkpoint: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
