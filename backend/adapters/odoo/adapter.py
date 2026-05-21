from __future__ import annotations

import time
from dataclasses import dataclass

from adapters.base import BaseAdapter, ConnectorHealth
from adapters.odoo.client import OdooClient


@dataclass
class OdooConfig:
    url: str
    database: str
    username: str
    password: str
    api_key: str | None = None


class OdooAdapter(BaseAdapter):
    def __init__(self, config: dict | None = None):
        self._client: OdooClient | None = None
        self._config: OdooConfig | None = None
        self._init_config = config

    @property
    def adapter_type(self) -> str:
        return "odoo"

    async def connect(self) -> None:
        if self._init_config:
            await self.initialize(self._init_config)

    async def initialize(self, config: dict) -> None:
        self._config = OdooConfig(
            url=config["url"],
            database=config["database"],
            username=config["username"],
            password=config.get("password", ""),
            api_key=config.get("api_key"),
        )
        self._client = OdooClient(
            url=self._config.url,
            database=self._config.database,
            username=self._config.username,
            password=self._config.password,
            api_key=self._config.api_key,
        )
        await self._client.authenticate()

    async def health_check(self) -> ConnectorHealth:
        if not self._client:
            return ConnectorHealth(status="down", latency_ms=0, last_error="Not initialized")
        start = time.monotonic()
        try:
            await self._client.search_read("res.lang", [], fields=["id"], limit=1)
            latency = int((time.monotonic() - start) * 1000)
            return ConnectorHealth(status="healthy", latency_ms=latency)
        except Exception as e:
            latency = int((time.monotonic() - start) * 1000)
            return ConnectorHealth(status="down", latency_ms=latency, last_error=str(e))

    async def dispose(self) -> None:
        self._client = None
        self._config = None

    def _model_for(self, resource: str) -> str:
        mapping = {
            "job": "hr.job",
            "candidate": "hr.candidate",
            "applicant": "hr.applicant",
            "department": "hr.department",
            "employee": "hr.employee",
        }
        return mapping.get(resource, resource)

    async def list(
        self,
        resource: str,
        filters: dict | None = None,
        limit: int = 100,
        offset: int = 0,
        fields: list[str] | None = None,
    ) -> list[dict]:
        model = self._model_for(resource)
        domain = self._build_domain(filters)
        return await self._client.search_read(model, domain, fields, limit=limit, offset=offset)

    async def get(self, resource: str, id: str) -> dict | None:
        model = self._model_for(resource)
        results = await self._client.search_read(model, [("id", "=", int(id))])
        return results[0] if results else None

    async def create(self, resource: str, data: dict) -> str:
        model = self._model_for(resource)
        result = await self._client.call(model, "create", [data])
        return str(result)

    async def update(self, resource: str, id: str, data: dict) -> None:
        model = self._model_for(resource)
        await self._client.call(model, "write", [[int(id)], data])

    async def upsert(self, resource: str, data: dict, key: str | None = None) -> str:
        model = self._model_for(resource)
        if key and key in data:
            existing = await self._client.search_read(
                model, [(key, "=", data[key])], fields=["id"]
            )
            if existing:
                record_id = existing[0]["id"]
                await self._client.call(model, "write", [[record_id], data])
                return str(record_id)
        return await self.create(resource, data)

    def _build_domain(self, filters: dict | None) -> list:
        if not filters:
            return []
        domain = []
        for key, value in filters.items():
            if isinstance(value, (list, tuple)):
                domain.append((key, value[0], value[1]))
            else:
                domain.append((key, "=", value))
        return domain
