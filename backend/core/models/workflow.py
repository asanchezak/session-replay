from enum import Enum

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class WorkflowStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"

    @classmethod
    def valid_transitions(cls, current: str, target: str) -> bool:
        transitions = {
            cls.ACTIVE: {cls.ARCHIVED},
            cls.ARCHIVED: set(),
        }
        return target in transitions.get(cls(current), set())


class WorkflowType(str, Enum):
    SYSTEM = "system"
    USER = "user"


class Workflow(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflows"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", index=True
    )
    workflow_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="user", index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class WorkflowStep(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "workflow_steps"

    workflow_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    action_type: Mapped[str] = mapped_column(String(30), nullable=False)
    intent: Mapped[str | None] = mapped_column(Text, nullable=True)
    selector_chain: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    methods: Mapped[list | None] = mapped_column(JSON, nullable=True)
    accessibility_metadata: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    text_anchors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    dom_context: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    success_condition: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    failure_condition: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ai_hint: Mapped[str | None] = mapped_column(Text, nullable=True)
    checkpoint: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Phase 5: selector stability — 1.0 = stable, 0.0 = always healed.
    # Updated by learning_service after each terminal run.
    selector_stability_score: Mapped[float | None] = mapped_column(nullable=True)
    heal_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
