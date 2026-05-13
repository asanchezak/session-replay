from enum import Enum

from sqlalchemy import JSON, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class ArtifactType(str, Enum):
    SCREENSHOT = "screenshot"
    DOM_SNAPSHOT = "dom_snapshot"
    A11Y_TREE = "a11y_tree"


class Artifact(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "artifacts"

    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    artifact_type: Mapped[str] = mapped_column(String(20), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    meta_data: Mapped[dict | None] = mapped_column("metadata", JSON, nullable=True)
