from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ConnectorHealth:
    status: str  # "healthy" | "degraded" | "down"
    latency_ms: int
    last_error: str | None = None


class BaseAdapter(ABC):
    @property
    @abstractmethod
    def adapter_type(self) -> str:
        ...

    @abstractmethod
    async def initialize(self, config: dict) -> None:
        ...

    @abstractmethod
    async def health_check(self) -> ConnectorHealth:
        ...

    @abstractmethod
    async def dispose(self) -> None:
        ...

    @abstractmethod
    async def list(self, resource: str, filters: dict | None = None) -> list[dict]:
        ...

    @abstractmethod
    async def get(self, resource: str, id: str) -> dict | None:
        ...

    @abstractmethod
    async def create(self, resource: str, data: dict) -> str:
        ...

    @abstractmethod
    async def update(self, resource: str, id: str, data: dict) -> None:
        ...

    @abstractmethod
    async def upsert(self, resource: str, data: dict) -> str:
        ...
