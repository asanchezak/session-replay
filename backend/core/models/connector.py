from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from core.models.base import Base, TimestampMixin, UUIDMixin


class ConnectorConfig(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "connector_configs"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    connector_type: Mapped[str] = mapped_column(String(50), nullable=False)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
